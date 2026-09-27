import serverlessHttp from "serverless-http";
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from "aws-lambda";
import { app } from "../index.js";

const serverlessApp = serverlessHttp(app);

export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  context.callbackWaitsForEmptyEventLoop = false;
  return serverlessApp(event, context) as unknown as APIGatewayProxyResult;
};