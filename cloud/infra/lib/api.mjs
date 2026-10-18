// BridgeApi: accounts (Sign in with Apple, cloud/api/auth.mjs), the voice API (HTTP API + Lambda),
// its table (DynamoDB) and push to the app (APNs, cloud/api/push.mjs). The API is its own token issuer: sessions are signed by a KMS key, and
// API Gateway's JWT authorizer reads the discovery document and key set the Auth function serves.
import { Stack, Duration, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { fileURLToPath } from 'node:url';

const API_DIR = fileURLToPath(new URL('../../api', import.meta.url));
const LOOK_MODEL = 'us.anthropic.claude-haiku-5-5';   // quick photo answers: fast and cheap
const BUNDLE_ID = 'com.smitherman.glassesrelay';     // Apple identity tokens' audience, and the push topic
const APNS_SECRET = 'bridge/apns';                   // { teamId, keyId, key }: cloud/setup/setup-apns.ps1

export class ApiStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const table = new dynamodb.TableV2(this, 'Data', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),          // pay per request: nothing when idle
      timeToLiveAttribute: 'expires',                // inbox messages remove themselves
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const voice = new lambda.Function(this, 'Voice', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(API_DIR, { exclude: ['*.test.mjs'] }),
      timeout: Duration.seconds(29),                 // HTTP API's limit is 30s; the inbox waits up to ~20s
      memorySize: 512,
      environment: { TABLE: table.tableName, LOOK_MODEL, BUNDLE_ID, APNS_SECRET },
      logGroup: new logs.LogGroup(this, 'VoiceLogs', { retention: logs.RetentionDays.ONE_MONTH }),
    });
    table.grantReadWriteData(voice);
    // Created outside CDK so the .p8 never passes through a template. Until it exists, push stays off.
    secrets.Secret.fromSecretNameV2(this, 'ApnsKey', APNS_SECRET).grantRead(voice);
    // A cross-region inference profile needs the profile and the model it routes to, in every US region.
    voice.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${LOOK_MODEL}`,
        `arn:aws:bedrock:*::foundation-model/${LOOK_MODEL.replace(/^us\./, '')}`,
      ],
    }));

    const api = new apigw.HttpApi(this, 'Http', { apiName: 'bridge-api' });

    // Session signing key: RSA in KMS, so the private half can't be read or leaked.
    const signingKey = new kms.Key(this, 'SessionKey', {
      description: 'Signs Bridge Cloud session tokens',
      keySpec: kms.KeySpec.RSA_2048,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      removalPolicy: RemovalPolicy.RETAIN,   // deleting it signs everyone out
    });
    const authFn = new lambda.Function(this, 'Auth', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.auth',
      code: lambda.Code.fromAsset(API_DIR, { exclude: ['*.test.mjs'] }),
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: { TABLE: table.tableName, ISSUER: api.apiEndpoint, BUNDLE_ID, SIGNING_KEY: signingKey.keyArn },
      logGroup: new logs.LogGroup(this, 'AuthLogs', { retention: logs.RetentionDays.ONE_MONTH }),
    });
    authFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['kms:Sign', 'kms:GetPublicKey'], resources: [signingKey.keyArn] }));
    table.grantReadWriteData(authFn);   // deleting an account removes its data

    const sessions = new HttpJwtAuthorizer('Session', api.apiEndpoint, { jwtAudience: [BUNDLE_ID] });
    const authIntegration = new HttpLambdaIntegration('AuthIntegration', authFn);
    const voiceIntegration = new HttpLambdaIntegration('VoiceIntegration', voice);
    const routes = [
      ['GET', '/.well-known/openid-configuration', authIntegration, null],
      ['GET', '/.well-known/jwks.json', authIntegration, null],
      ['POST', '/api/auth/apple', authIntegration, null],
      ['POST', '/api/auth/refresh', authIntegration, sessions],
      ['DELETE', '/api/account', authIntegration, sessions],
      ['POST', '/api/voice/confirm', voiceIntegration, sessions],
      ['POST', '/api/voice/send', voiceIntegration, sessions],
      ['GET', '/api/voice/inbox', voiceIntegration, sessions],
      ['POST', '/api/voice/photo', voiceIntegration, sessions],
      ['POST', '/api/push/register', voiceIntegration, sessions],
      ['DELETE', '/api/push/register', voiceIntegration, sessions],
      ['POST', '/api/push/test', voiceIntegration, sessions],
    ];
    for (const [method, path, integration, authorizer] of routes) {
      api.addRoutes({ path, methods: [apigw.HttpMethod[method]], integration, ...(authorizer ? { authorizer } : {}) });
    }

    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
  }
}
