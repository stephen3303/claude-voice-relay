// BridgeWeb: the website (site/) on a private S3 bucket behind CloudFront.
// The custom domain (talktobridge.com) is added once it's registered; until then the
// CloudFront address serves the site.
import { Stack, RemovalPolicy, Duration, CfnOutput } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as deploy from 'aws-cdk-lib/aws-s3-deployment';
import { fileURLToPath } from 'node:url';

const SITE_DIR = fileURLToPath(new URL('../../../site', import.meta.url));

export class WebStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'Site', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,   // readable only through CloudFront
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const headers = new cloudfront.ResponseHeadersPolicy(this, 'Headers', {
      securityHeadersBehavior: {
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
        // The site has no scripts and loads nothing from elsewhere.
        contentSecurityPolicy: { contentSecurityPolicy: "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'none'; frame-ancestors 'none'", override: true },
      },
    });

    const site = new cloudfront.Distribution(this, 'Cdn', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: headers,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      errorResponses: [{ httpStatus: 403, responseHttpStatus: 404, responsePagePath: '/index.html', ttl: Duration.minutes(5) }],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,   // North America and Europe edges: cheapest
    });

    new deploy.BucketDeployment(this, 'Publish', {
      sources: [deploy.Source.asset(SITE_DIR)],
      destinationBucket: bucket,
      distribution: site,          // invalidates the cache on each deploy
      distributionPaths: ['/*'],
    });

    new CfnOutput(this, 'SiteUrl', { value: `https://${site.distributionDomainName}` });
  }
}
