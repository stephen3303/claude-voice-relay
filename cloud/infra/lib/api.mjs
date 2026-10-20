// BridgeApi: accounts (Sign in with Apple, cloud/api/auth.mjs), the voice API (HTTP API + Lambda),
// its table (DynamoDB) and push to the app (APNs, cloud/api/push.mjs). Sessions are signed by a
// KMS key; a Lambda authorizer checks them.
import { Stack, Duration, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpLambdaAuthorizer, HttpLambdaResponseType } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { IgnoreMode } from 'aws-cdk-lib';
import { fileURLToPath } from 'node:url';

const API_DIR = fileURLToPath(new URL('../../api', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const LOOK_MODEL = 'us.anthropic.claude-haiku-5-5';   // quick photo answers: fast and cheap
const BUNDLE_ID = 'com.talktobridge.bridge';     // Apple identity tokens' audience, and the push topic
const ISSUER = 'https://talktobridge.com';           // Bridge session tokens' issuer
const APNS_SECRET = 'bridge/apns';                   // { teamId, keyId, key }: cloud/setup/setup-apns.ps1
// The owner account (cloud/api/owner.mjs), both made by cloud/setup/setup-owner.ps1, never by CDK:
const OWNER_SECRET = 'bridge/owner';                 // { tokenHash }: the owner token's SHA-256
const OWNER_CLAUDE_SECRET = 'bridge/owner-claude';   // the owner's claude.ai login (+ routine, ntfy), runner only
const OWNER_ROUTINE_SECRET = 'bridge/owner-routine'; // { url, token }: the routine new tasks start as, runner only

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

    // Spoken replies (/api/voice/tts), in this region only. A call without lexicons names no resource, so
    // the grant can't be narrowed by ARN; the region condition does the scoping.
    voice.addToRolePolicy(new iam.PolicyStatement({
      actions: ['polly:SynthesizeSpeech'],
      resources: ['*'],
      conditions: { StringEquals: { 'aws:RequestedRegion': this.region } },
    }));

    // ---------- agent runner (cloud/runner): one Fargate task per busy agent of the owner ----------
    // Public subnets with a public IP and no NAT gateway (about $32 a month idle): the task only calls out
    // (claude.ai, GitHub, AWS APIs) and takes no connections in. Nothing runs between tasks.
    const vpc = new ec2.Vpc(this, 'RunnerVpc', {
      maxAzs: 2, natGateways: 0,   // the region's zones are in cdk.json, so synth needs no AWS lookup
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC }],
    });
    const runnerSg = new ec2.SecurityGroup(this, 'RunnerSg', { vpc, description: 'Agent runner: outbound only', allowAllOutbound: true });
    const cluster = new ecs.Cluster(this, 'Runners', { vpc });
    const runnerTask = new ecs.FargateTaskDefinition(this, 'Runner', {
      cpu: 512, memoryLimitMiB: 1024,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    runnerTask.addContainer('runner', {
      // Built from the repo root with only what cloud/runner/Dockerfile copies (it reuses the relay's modules).
      image: ecs.ContainerImage.fromAsset(REPO_ROOT, {
        file: 'cloud/runner/Dockerfile',
        platform: Platform.LINUX_AMD64,
        ignoreMode: IgnoreMode.DOCKER,
        exclude: ['*', '!cloud-agents.mjs', '!agent-turn.mjs', '!ntfy.mjs', '!cloud/api/*.mjs', 'cloud/api/*.test.mjs',
          '!cloud/runner/*.mjs', 'cloud/runner/*.test.mjs', '!cloud/runner/package.json', '!cloud/runner/package-lock.json',
          '!cloud/runner/Dockerfile'],
      }),
      environment: { TABLE: table.tableName, CLAUDE_SECRET: OWNER_CLAUDE_SECRET, ROUTINE_SECRET: OWNER_ROUTINE_SECRET },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'runner',
        logGroup: new logs.LogGroup(this, 'RunnerLogs', { retention: logs.RetentionDays.ONE_MONTH }) }),
    });
    // Its agent's record and the inbox: item reads and writes only.
    runnerTask.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
      resources: [table.tableArn],
    }));
    // Reads the owner's claude.ai login, and writes it back when Claude Code refreshed it.
    const ownerClaude = secrets.Secret.fromSecretNameV2(this, 'OwnerClaude', OWNER_CLAUDE_SECRET);
    ownerClaude.grantRead(runnerTask.taskRole);
    ownerClaude.grantWrite(runnerTask.taskRole);
    secrets.Secret.fromSecretNameV2(this, 'OwnerRoutine', OWNER_ROUTINE_SECRET).grantRead(runnerTask.taskRole);
    voice.addEnvironment('RUNNER_CLUSTER', cluster.clusterArn);
    voice.addEnvironment('RUNNER_TASK', runnerTask.taskDefinitionArn);
    voice.addEnvironment('RUNNER_SUBNETS', vpc.publicSubnets.map((sn) => sn.subnetId).join(','));
    voice.addEnvironment('RUNNER_SECURITY_GROUP', runnerSg.securityGroupId);
    voice.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:RunTask'],
      resources: [`arn:aws:ecs:${this.region}:${this.account}:task-definition/${runnerTask.family}:*`],
      conditions: { ArnEquals: { 'ecs:cluster': cluster.clusterArn } },
    }));
    voice.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:StopTask'],
      resources: [`arn:aws:ecs:${this.region}:${this.account}:task/${cluster.clusterName}/*`],
    }));
    voice.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [runnerTask.taskRole.roleArn, runnerTask.obtainExecutionRole().roleArn],
      conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
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
      environment: { TABLE: table.tableName, ISSUER, BUNDLE_ID, SIGNING_KEY: signingKey.keyArn },
      logGroup: new logs.LogGroup(this, 'AuthLogs', { retention: logs.RetentionDays.ONE_MONTH }),
    });
    authFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['kms:Sign', 'kms:GetPublicKey'], resources: [signingKey.keyArn] }));
    table.grantReadWriteData(authFn);   // deleting an account removes its data

    const authorizerFn = new lambda.Function(this, 'Authorizer', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.authorize',
      code: lambda.Code.fromAsset(API_DIR, { exclude: ['*.test.mjs'] }),
      timeout: Duration.seconds(5),
      memorySize: 256,
      environment: { TABLE: table.tableName, ISSUER, BUNDLE_ID, SIGNING_KEY: signingKey.keyArn, OWNER_SECRET },
      logGroup: new logs.LogGroup(this, 'AuthorizerLogs', { retention: logs.RetentionDays.ONE_MONTH }),
    });
    // Only the owner token's hash; until the secret exists nobody is the owner.
    secrets.Secret.fromSecretNameV2(this, 'OwnerToken', OWNER_SECRET).grantRead(authorizerFn);
    authorizerFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['kms:GetPublicKey'], resources: [signingKey.keyArn] }));
    const sessions = new HttpLambdaAuthorizer('Session', authorizerFn, {
      responseTypes: [HttpLambdaResponseType.SIMPLE],
      resultsCacheTtl: Duration.minutes(5),   // per Authorization header
    });
    const authIntegration = new HttpLambdaIntegration('AuthIntegration', authFn);
    const voiceIntegration = new HttpLambdaIntegration('VoiceIntegration', voice);
    const routes = [
      ['POST', '/api/auth/apple', authIntegration, null],
      ['POST', '/api/auth/refresh', authIntegration, sessions],
      ['DELETE', '/api/account', authIntegration, sessions],
      ['POST', '/api/voice/confirm', voiceIntegration, sessions],
      ['POST', '/api/voice/send', voiceIntegration, sessions],
      ['GET', '/api/voice/inbox', voiceIntegration, sessions],
      ['POST', '/api/voice/photo', voiceIntegration, sessions],
      ['POST', '/api/voice/tts', voiceIntegration, sessions],
      ['POST', '/api/pro', voiceIntegration, sessions],
      ['DELETE', '/api/voice/listening', voiceIntegration, sessions],
      ['POST', '/api/push/register', voiceIntegration, sessions],
      ['DELETE', '/api/push/register', voiceIntegration, sessions],
      ['POST', '/api/push/test', voiceIntegration, sessions],
    ];
    const throttled = [];   // routes the stage's route settings name, below
    for (const [method, path, integration, authorizer] of routes) {
      const added = api.addRoutes({ path, methods: [apigw.HttpMethod[method]], integration, ...(authorizer ? { authorizer } : {}) });
      if (path === '/api/voice/tts') throttled.push(...added);
    }

    // Claude connector (cloud/api/connector.mjs): the MCP server and the OAuth server Claude signs in
    // through. No API Gateway authorizer: MCP clients need a 401 with a WWW-Authenticate header to
    // find the sign-in, so the Lambda checks its own tokens. Its tokens can't pass the app's authorizer
    // (another audience). The well-known addresses sit at the root because OAuth clients look there.
    const SERVICES_ID = 'com.talktobridge.bridge.web';   // Sign in with Apple for the web (Apple Developer, Identifiers)
    const connectorFn = new lambda.Function(this, 'Connector', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.connector',
      code: lambda.Code.fromAsset(API_DIR, { exclude: ['*.test.mjs'] }),
      timeout: Duration.seconds(15),
      memorySize: 256,
      environment: { TABLE: table.tableName, ISSUER, BUNDLE_ID, SIGNING_KEY: signingKey.keyArn, SERVICES_ID },
      logGroup: new logs.LogGroup(this, 'ConnectorLogs', { retention: logs.RetentionDays.ONE_MONTH }),
    });
    connectorFn.addToRolePolicy(new iam.PolicyStatement({ actions: ['kms:Sign', 'kms:GetPublicKey'], resources: [signingKey.keyArn] }));
    table.grantReadWriteData(connectorFn);
    const connectorIntegration = new HttpLambdaIntegration('ConnectorIntegration', connectorFn);
    const connectorRoutes = [
      [['POST', 'GET', 'DELETE'], '/api/mcp'],
      [['GET'], '/.well-known/oauth-protected-resource'],
      [['GET'], '/.well-known/oauth-protected-resource/api/mcp'],
      [['GET'], '/.well-known/oauth-authorization-server'],
      [['POST'], '/api/oauth/register'],
      [['GET'], '/api/oauth/authorize'],
      [['POST'], '/api/oauth/apple'],
      [['POST'], '/api/oauth/token'],
    ];
    const stage = api.defaultStage.node.defaultChild;
    for (const route of throttled) stage.node.addDependency(route);
    for (const [methods, path] of connectorRoutes) {
      for (const route of api.addRoutes({ path, methods: methods.map((m) => apigw.HttpMethod[m]), integration: connectorIntegration })) {
        stage.node.addDependency(route);   // route settings below name these routes
      }
    }
    // Registration and sign-in need no account, and each writes a row: keep a loop from filling the table.
    // routeSettings is a raw JSON property, so CDK passes these keys through as is; CloudFormation wants PascalCase.
    stage.routeSettings = {
      'POST /api/oauth/register': { ThrottlingRateLimit: 1, ThrottlingBurstLimit: 5 },
      'GET /api/oauth/authorize': { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 20 },
      // Shared by every caller: a backstop against floods. Cost is capped per account and per day in voice.mjs.
      'POST /api/voice/tts': { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
      // Open to anyone; only Apple's signed notifications get past the Lambda. High enough that junk can't crowd
      // out Apple's retries of a refund.
      'POST /api/appstore/notifications': { ThrottlingRateLimit: 50, ThrottlingBurstLimit: 100 },
    };
    // App Store Server Notifications v2 (cloud/api/storekit.mjs): renewals and refunds of Bridge Pro. No authorizer:
    // Apple signs every notification, and the Lambda checks that signature against Apple's root.
    const appStoreFn = new lambda.Function(this, 'AppStore', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.appStore',
      code: lambda.Code.fromAsset(API_DIR, { exclude: ['*.test.mjs'] }),
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: { TABLE: table.tableName, BUNDLE_ID },
      logGroup: new logs.LogGroup(this, 'AppStoreLogs', { retention: logs.RetentionDays.ONE_MONTH }),
    });
    // Anyone can reach it, so it gets only the item calls storekit.mjs makes, not Query or Scan.
    appStoreFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
      resources: [table.tableArn],
    }));
    for (const route of api.addRoutes({ path: '/api/appstore/notifications', methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration('AppStoreIntegration', appStoreFn) })) {
      stage.node.addDependency(route);
    }

    new CfnOutput(this, 'ConnectorUrl', { value: `${api.apiEndpoint}/api/mcp` });
    new CfnOutput(this, 'AppleReturnUrl', { value: `${api.apiEndpoint}/api/oauth/apple` });

    // App Store Connect > the app > App Information > App Store Server Notifications (Version 2, production and sandbox).
    new CfnOutput(this, 'AppStoreNotificationsUrl', { value: `${api.apiEndpoint}/api/appstore/notifications` });

    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    // For cloud/setup/setup-owner.ps1, which writes the owner's projects.
    new CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
