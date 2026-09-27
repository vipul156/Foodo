import "./sst-env.d.ts";
import process from "node:process";
import {
  CloudFormationClient,
  ListExportsCommand,
} from "@aws-sdk/client-cloudformation";

/**
 * Dynamically queries CloudFormation exports from Serverless Framework stacks
 * (e.g. foodo-core-api-<stage>-HttpApiUrl, foodo-realtime-<stage>-WebSocketUrl)
 */
async function getCloudFormationExport(
  exportName: string,
  region = "ap-south-1",
): Promise<string | undefined> {
  try {
    const cfn = new CloudFormationClient({ region });
    let nextToken: string | undefined;

    do {
      const response = await cfn.send(
        new ListExportsCommand({ NextToken: nextToken }),
      );
      const match = response.Exports?.find((exp) => exp.Name === exportName);
      if (match?.Value) return match.Value;
      nextToken = response.NextToken;
    } while (nextToken);
  } catch {
    // Graceful fallback when credentials or stacks aren't available yet
  }
  return undefined;
}

export default $config({
  app(input) {
    return {
      name: "foodo-web",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      home: "aws",
      providers: {
        aws: {
          region: "ap-south-1",
        },
      },
    };
  },
  async run() {
    const stage = $app.stage;

    // Zero-Cost Reverse Proxy (Single Origin on CloudFront):
    // Next.js runs on https://<id>.cloudfront.net/
    // Browser calls relative /api/* (e.g. /api/auth/login), which flows through
    // the same CloudFront origin. No custom domain needed, no CORS issues,
    // and cookies are 100% same-origin first-party.
    //
    // Automatically retrieve the live endpoints from the deployed Serverless Framework stacks:
    const deployedHttpApiUrl = await getCloudFormationExport(
      `foodo-core-api-${stage}-HttpApiUrl`,
    );
    const deployedWebSocketUrl = await getCloudFormationExport(
      `foodo-realtime-${stage}-WebSocketUrl`,
    );

    const coreApiEndpoint =
      process.env.API_GATEWAY_URL ||
      deployedHttpApiUrl ||
      `https://foodo-core-api-${stage}.execute-api.ap-south-1.amazonaws.com`;

    const realtimeWsUrl =
      process.env.NEXT_PUBLIC_REALTIME_WS_URL ||
      deployedWebSocketUrl ||
      `wss://foodo-realtime-${stage}.execute-api.ap-south-1.amazonaws.com/${stage}`;

    // Deploy Next.js via SST Ion native OpenNext integration
    const site = new sst.aws.Nextjs("FoodoWeb", {
      path: ".",
      environment: {
        NEXT_PUBLIC_STAGE: stage,
        // Since browser and API are on the exact same CloudFront origin,
        // client-side API requests use relative paths or site.url:
        NEXT_PUBLIC_API_URL: "",
        NEXT_PUBLIC_REALTIME_WS_URL: realtimeWsUrl,
      },
      // CloudFront reverse proxy behavior:
      // Route all /api/* requests directly to API Gateway HTTP origin
      transform: {
        cdn: (args) => {
          args.origins = [
            ...(args.origins || []),
            {
              originId: "ApiGatewayBackend",
              domainName: coreApiEndpoint.replace(/^https?:\/\//, ""),
              customOriginConfig: {
                httpPort: 80,
                httpsPort: 443,
                originProtocolPolicy: "https-only",
                originSslProtocols: ["TLSv1.2"],
              },
            },
          ];

          args.orderedCacheBehaviors = [
            {
              pathPattern: "api/*",
              targetOriginId: "ApiGatewayBackend",
              viewerProtocolPolicy: "redirect-to-https",
              allowedMethods: [
                "GET",
                "HEAD",
                "OPTIONS",
                "PUT",
                "POST",
                "PATCH",
                "DELETE",
              ],
              cachedMethods: ["GET", "HEAD"],
              // Do NOT cache dynamic API responses; pass all headers and cookies
              defaultTtl: 0,
              minTtl: 0,
              maxTtl: 0,
              compress: true,
              forwardedValues: {
                queryString: true,
                cookies: { forward: "all" },
                headers: ["*"],
              },
            },
            ...(args.orderedCacheBehaviors || []),
          ];
        },
      },
      server: {
        memory: "1024 MB",
        timeout: "15 seconds",
        architecture: "arm64",
      },
      imageOptimization: {
        memory: "1536 MB",
      },
    });

    return {
      siteUrl: site.url,
      distributionId: site.nodes.cdn?.id,
    };
  },
});
