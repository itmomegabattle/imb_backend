import type { IncomingMessage, ServerResponse } from "node:http";
import { buildApp } from "../src/app.js";

export const config = { maxDuration: 60 };

const appPromise = buildApp().then(async (app) => {
  await app.ready();
  return app;
});

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  const app = await appPromise;
  app.server.emit("request", request, response);
}
