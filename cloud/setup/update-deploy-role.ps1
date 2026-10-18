# Scopes the BridgeGitHubDeploy role to the aws-deploy environment instead of "any workflow on main".
# Run it yourself, from this folder, signed in to AWS and to GitHub (gh auth login):
#   powershell -ExecutionPolicy Bypass -File update-deploy-role.ps1
# Best run just before merging the PR that adds `environment: aws-deploy` to cloud-deploy.yml: that
# merge starts a Cloud deploy, which then works first time. Any deploy that runs between this script and
# the merge fails without changing anything; rerun it.
$ErrorActionPreference = 'Stop'
$repo = 'stephen3303/claude-voice-relay'
$region = 'us-east-1'
$template = "$PSScriptRoot\github-deploy-role.yml"

# Deploying an older template from main would put back the "any workflow on main" trust.
if (-not (Select-String -Quiet 'environment:aws-deploy' $template)) {
  throw 'This template still has the old trust. Run the script from the branch that has the aws-deploy trust policy.'
}

# The trust matches GitHub's default subject for a job with an environment. A custom subject template
# that leaves out "environment" would never match it.
$sub = gh api "repos/$repo/actions/oidc/customization/sub" | ConvertFrom-Json
if ($LASTEXITCODE) { throw 'reading the OIDC subject settings failed' }
if (-not $sub.use_default -and $sub.include_claim_keys -notcontains 'environment') {
  throw "The repo's OIDC subject template ($($sub.include_claim_keys -join ', ')) has no environment claim; the new trust would never match."
}

# 1. The environment, accepting deployments from main only. Without this rule, a workflow on any branch
#    could name the environment and get a token the role trusts.
'{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' |
  gh api -X PUT "repos/$repo/environments/aws-deploy" --input - | Out-Null
if ($LASTEXITCODE) { throw 'creating the aws-deploy environment failed' }
$names = gh api "repos/$repo/environments/aws-deploy/deployment-branch-policies" --jq '.branch_policies[].name'
if ($names -notcontains 'main') {
  gh api -X POST "repos/$repo/environments/aws-deploy/deployment-branch-policies" -f name=main -f type=branch | Out-Null
  if ($LASTEXITCODE) { throw 'adding the main branch rule failed' }
}
Write-Host 'Environment aws-deploy: main only'

# 2. The role's new trust policy.
aws cloudformation deploy --region $region --stack-name BridgeGitHubDeploy `
  --template-file $template --capabilities CAPABILITY_NAMED_IAM
if ($LASTEXITCODE) { throw 'deploy role stack failed' }
aws iam get-role --role-name BridgeGitHubDeploy `
  --query 'Role.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals' --output json

Write-Host 'Done. Rerun Actions > Cloud deploy to check it still deploys.'
