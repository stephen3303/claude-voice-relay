// Bridge Cloud infrastructure (see cloud/DESIGN.md). Deployed by .github/workflows/cloud-deploy.yml.
import { App } from 'aws-cdk-lib';
import { WebStack } from '../lib/web.mjs';
import { ApiStack } from '../lib/api.mjs';

const app = new App();
const env = { account: '651325958035', region: 'us-east-1' };

new WebStack(app, 'BridgeWeb', { env, description: 'Bridge website: S3 + CloudFront' });
new ApiStack(app, 'BridgeApi', { env, description: 'Bridge accounts and voice API: Cognito, HTTP API, Lambda, DynamoDB' });
