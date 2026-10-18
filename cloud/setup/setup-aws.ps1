# One-time AWS setup for Bridge Cloud. Run it yourself, from this folder, signed in to the AWS account:
#   powershell -ExecutionPolicy Bypass -File setup-aws.ps1
# It does three things in us-east-1, and then Claude deploys only through GitHub Actions:
#   1. cdk bootstrap: the CDK deploy roles and asset bucket (stack CDKToolkit)
#   2. github-deploy-role.yml: GitHub sign-in (OIDC) and the BridgeGitHubDeploy role (stack BridgeGitHubDeploy)
#   3. saves the role ARN as the AWS_DEPLOY_ROLE_ARN repository variable
$ErrorActionPreference = 'Stop'
$account = aws sts get-caller-identity --query Account --output text
$region = 'us-east-1'
Write-Host "Account $account, region $region"

npx --yes aws-cdk@2 bootstrap "aws://$account/$region" --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
if ($LASTEXITCODE) { throw 'cdk bootstrap failed' }

aws cloudformation deploy --region $region --stack-name BridgeGitHubDeploy `
  --template-file "$PSScriptRoot\github-deploy-role.yml" --capabilities CAPABILITY_NAMED_IAM
if ($LASTEXITCODE) { throw 'deploy role stack failed' }

$arn = aws cloudformation describe-stacks --region $region --stack-name BridgeGitHubDeploy `
  --query "Stacks[0].Outputs[?OutputKey=='RoleArn'].OutputValue" --output text
gh variable set AWS_DEPLOY_ROLE_ARN --repo stephen3303/claude-voice-relay --body $arn
Write-Host "Done. Deploy role: $arn"
Write-Host 'Then run update-deploy-role.ps1: the role only trusts the aws-deploy environment, which it creates.'
Write-Host 'Next: delete the root access key (IAM > Security credentials) so this PC no longer holds root keys.'
