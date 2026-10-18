// BridgeApi: accounts (Cognito), the voice API (HTTP API + Lambda) and its table (DynamoDB).
// Sign in with Apple is added to the user pool once the Apple Developer account exists
// (it needs a Services ID and key); email sign-in works until then.
import { Stack, Duration, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { fileURLToPath } from 'node:url';

const API_DIR = fileURLToPath(new URL('../../api', import.meta.url));
const LOOK_MODEL = 'us.anthropic.claude-haiku-5-5';   // quick photo answers: fast and cheap

export class ApiStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const users = new cognito.UserPool(this, 'Users', {
      userPoolName: 'bridge-users',
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: { minLength: 10 },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const appClient = users.addClient('IosApp', {
      userPoolClientName: 'bridge-ios',
      generateSecret: false,                        // a phone app can't keep a secret
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(90),
    });

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
      environment: { TABLE: table.tableName, LOOK_MODEL },
      logGroup: new logs.LogGroup(this, 'VoiceLogs', { retention: logs.RetentionDays.ONE_MONTH }),
    });
    table.grantReadWriteData(voice);
    // A cross-region inference profile needs the profile and the model it routes to, in every US region.
    voice.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${LOOK_MODEL}`,
        `arn:aws:bedrock:*::foundation-model/${LOOK_MODEL.replace(/^us\./, '')}`,
      ],
    }));

    const api = new apigw.HttpApi(this, 'Http', {
      apiName: 'bridge-api',
      defaultAuthorizer: new HttpJwtAuthorizer('Cognito',
        `https://cognito-idp.${this.region}.amazonaws.com/${users.userPoolId}`,
        { jwtAudience: [appClient.userPoolClientId] }),
    });
    const integration = new HttpLambdaIntegration('VoiceIntegration', voice);
    for (const [method, path] of [['POST', '/api/voice/confirm'], ['GET', '/api/voice/inbox'], ['POST', '/api/voice/photo']]) {
      api.addRoutes({ path, methods: [apigw.HttpMethod[method]], integration });
    }

    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new CfnOutput(this, 'UserPoolId', { value: users.userPoolId });
    new CfnOutput(this, 'AppClientId', { value: appClient.userPoolClientId });
  }
}
