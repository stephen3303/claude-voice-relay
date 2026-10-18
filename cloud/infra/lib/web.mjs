// BridgeWeb: the website (site/) on a private S3 bucket behind CloudFront, at talktobridge.com.
// DNS is at Cloudflare (its registrar requires that), so the certificate is validated by a
// CNAME added there by hand: the deploy prints it and waits until it resolves. Then two more
// Cloudflare records point the names at CloudFront (DNS only, not proxied).
import { Stack, RemovalPolicy, Duration, CfnOutput } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as deploy from 'aws-cdk-lib/aws-s3-deployment';
import { fileURLToPath } from 'node:url';

const SITE_DIR = fileURLToPath(new URL('../../../site', import.meta.url));
export const DOMAIN = 'talktobridge.com';

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

    // CloudFront certificates must live in us-east-1, which is where this stack is.
    const certificate = new acm.Certificate(this, 'Cert', {
      domainName: DOMAIN,
      subjectAlternativeNames: [`www.${DOMAIN}`],
      validation: acm.CertificateValidation.fromDns(),   // no hosted zone: the CNAME goes in Cloudflare
    });

    const site = new cloudfront.Distribution(this, 'Cdn', {
      domainNames: [DOMAIN, `www.${DOMAIN}`],
      certificate,
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

    new CfnOutput(this, 'SiteUrl', { value: `https://${DOMAIN}` });
    new CfnOutput(this, 'CloudFrontTarget', { value: site.distributionDomainName,
      description: `Cloudflare: CNAME ${DOMAIN} and www to this, DNS only` });
  }
}
