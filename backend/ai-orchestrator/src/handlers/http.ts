import serverlessHttp from "serverless-http";
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from "aws-lambda";
import { app } from "../index.js";

// Lambda-mounted HTTP entrypoint (matches the sibling services' layout).
const serverlessApp = serverlessHttp(app);

export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  context.callbackWaitsForEmptyEventLoop = false;
  return serverlessApp(event, context) as unknown as APIGatewayProxyResult;
};
