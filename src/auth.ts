import { timingSafeEqual } from "node:crypto";
import { UserError } from "rivetkit";
export const internalParams = () => ({ authToken: process.env.APP_ACCESS_TOKEN || "" });
export function authorize(_c: unknown, params: { authToken?: string } | undefined) {
  const expected = Buffer.from(process.env.APP_ACCESS_TOKEN || "");
  const actual = Buffer.from(params?.authToken || "");
  if (!expected.length || actual.length !== expected.length || !timingSafeEqual(expected, actual)) {
    throw new UserError("Unauthorized", { code: "unauthorized" });
  }
}
