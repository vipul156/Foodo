import "./sst-env.d.ts";

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

    // Direct environment variables pointing to deployed backend services
    // or customizable custom subdomains under foodo.com
    const isProd = stage === "production";
    const apiHost = isProd ? "api.foodo.com" : `api.${stage}.foodo.com`;
    const wsHost = isProd ? "ws.foodo.com" : `ws.${stage}.foodo.com`;

    // Next.js deployed via SST Ion native OpenNext integration
    const site = new sst.aws.Nextjs("FoodoWeb", {
      path: ".",
      environment: {
        NEXT_PUBLIC_STAGE: stage,
        NEXT_PUBLIC_API_URL: `https://${apiHost}`,
        NEXT_PUBLIC_REALTIME_WS_URL: `wss://${wsHost}`,
      },
      domain: isProd
        ? {
            name: "app.foodo.com",
            dns: sst.aws.dns(),
          }
        : undefined,
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
