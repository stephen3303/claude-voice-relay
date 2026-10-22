# Gives the Bridge Cloud API its own address, https://api.talktobridge.com, so Sign in with Apple for the web
# (the Claude connector's Services ID) accepts it: Apple refuses *.execute-api.amazonaws.com as a domain.
#   powershell -ExecutionPolicy Bypass -File cloud\setup\setup-api-domain.ps1
# It asks for a certificate, waits while you add its check record in Cloudflare, then maps the address to the
# bridge-api HTTP API and prints the CNAME that points api.talktobridge.com at it. Running it again is harmless.
# Done with the AWS CLI rather than CDK, so it doesn't redeploy BridgeApi (which a main deploy would do).
$ErrorActionPreference = 'Stop'
$region = 'us-east-1'
$domain = 'api.talktobridge.com'

function Aws { $out = & aws @args --region $region --output json; if ($LASTEXITCODE) { throw "aws $($args[0..1] -join ' ') failed" }; if ($out) { $out | ConvertFrom-Json } }

# 1. The certificate (reuse one already requested for this name).
$cert = (Aws acm list-certificates --certificate-statuses PENDING_VALIDATION ISSUED).CertificateSummaryList |
  Where-Object { $_.DomainName -eq $domain } | Select-Object -First 1
$arn = if ($cert) { $cert.CertificateArn } else { (Aws acm request-certificate --domain-name $domain --validation-method DNS).CertificateArn }

$record = $null
for ($i = 0; $i -lt 10 -and -not $record; $i++) {
  $record = (Aws acm describe-certificate --certificate-arn $arn).Certificate.DomainValidationOptions[0].ResourceRecord
  if (-not $record) { Start-Sleep 3 }
}
$status = (Aws acm describe-certificate --certificate-arn $arn).Certificate.Status
if ($status -ne 'ISSUED') {
  Write-Host "`nIn Cloudflare (talktobridge.com > DNS > Add record), add this record, Proxy status: DNS only (grey cloud):"
  Write-Host "  Type:   CNAME"
  Write-Host "  Name:   $($record.Name.TrimEnd('.') -replace '\.talktobridge\.com$', '')"
  Write-Host "  Target: $($record.Value.TrimEnd('.'))"
  Write-Host "`nWaiting for AWS to see it (usually a few minutes)..."
  aws acm wait certificate-validated --certificate-arn $arn --region $region
  if ($LASTEXITCODE) { throw 'The certificate is still not validated. Check the record, then run this again.' }
}
Write-Host 'Certificate issued.'

# 2. The custom domain, mapped to the API's default stage.
$existing = & aws apigatewayv2 get-domain-name --domain-name $domain --region $region --output json 2>$null
$dn = if ($LASTEXITCODE) {
  Aws apigatewayv2 create-domain-name --domain-name $domain `
    --domain-name-configurations "CertificateArn=$arn,EndpointType=REGIONAL,SecurityPolicy=TLS_1_2"
} else { $existing | ConvertFrom-Json }
$apiId = ((Aws apigatewayv2 get-apis).Items | Where-Object { $_.Name -eq 'bridge-api' }).ApiId
if (-not $apiId) { throw 'No HTTP API named bridge-api in us-east-1' }
$mapped = (Aws apigatewayv2 get-api-mappings --domain-name $domain).Items | Where-Object { $_.ApiId -eq $apiId }
if (-not $mapped) { Aws apigatewayv2 create-api-mapping --domain-name $domain --api-id $apiId --stage '$default' | Out-Null }

$target = $dn.DomainNameConfigurations[0].ApiGatewayDomainName
Write-Host "`nLast step, in Cloudflare: add this record, Proxy status: DNS only (grey cloud):"
Write-Host "  Type:   CNAME"
Write-Host "  Name:   api"
Write-Host "  Target: $target"
Write-Host "`nThen https://$domain/.well-known/oauth-authorization-server answers within a few minutes."
