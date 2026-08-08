import { describe, expect, test } from "bun:test";
import { signOAuth1Request } from "../src/http-executor";

describe("OAuth 1.0a signer", () => {
  test("matches the RFC 5849 signature example", () => {
    const headers = { "Content-Type": "application/x-www-form-urlencoded" };
    signOAuth1Request(
      headers,
      "http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b",
      "POST",
      "c2&a3=2+q",
      { fields: {
        client_id: "9djdj82h48djs9d2",
        client_secret: "j49sk3j29djd",
        oauth_token: "kkk9d7dh3k39sjv7",
        oauth_token_secret: "dh893hdasih9",
      } },
      {},
      { nonce: "7d8f3e4a", timestamp: "137131201" },
    );
    expect(headers.Authorization).toContain("r6%2FTJjbCOr97%2F%2BUU0NsvSne7s5g%3D");
  });
});
