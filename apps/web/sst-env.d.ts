export type AppInput = {
  stage: string;
};

export type AppReturn = {
  name: string;
  removal?: "retain" | "remove";
  protect?: boolean;
  home?: string;
  providers?: Record<string, unknown>;
};

export type NextjsArgs = {
  path?: string;
  environment?: Record<string, string>;
  domain?: {
    name: string;
    dns?: unknown;
  };
  server?: {
    memory?: string;
    timeout?: string;
    architecture?: "x86_64" | "arm64";
  };
  imageOptimization?: {
    memory?: string;
  };
};

export interface NextjsInstance {
  readonly url: string;
  readonly nodes: {
    cdn?: {
      id: string;
    };
    [key: string]: unknown;
  };
}

export interface ConfigOptions {
  app(input: AppInput): AppReturn;
  run(): Promise<Record<string, unknown>> | Record<string, unknown> | void;
}

declare global {
  function $config(config: ConfigOptions): ConfigOptions;

  const $app: {
    stage: string;
    name: string;
  };

  namespace sst {
    namespace aws {
      function dns(): unknown;

      class Nextjs implements NextjsInstance {
        constructor(name: string, args?: NextjsArgs);
        readonly url: string;
        readonly nodes: {
          cdn?: {
            id: string;
          };
          [key: string]: unknown;
        };
      }
    }
  }
}
