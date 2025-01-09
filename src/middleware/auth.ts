import type { Context, Next } from "hono";

export const isAdmin = () => {
  const authToken = Bun.env.AUTHPASS;
  const headerName = "Authorization";

  return async (c: Context, next: Next) => {
    const authHeader = c.req.header(headerName);

    if (!authHeader) {
      return c.json({ message: "Authorization header is missing" }, 400);
    }

    // Handle Bearer token format if needed (common practice)
    const tokenParts = authHeader.split(" ");
    let tokenToCheck = authHeader;
    if (tokenParts.length === 2 && tokenParts[0].toLowerCase() === "bearer") {
      tokenToCheck = tokenParts[1];
    }

    if (tokenToCheck !== authToken) {
      return c.json({ message: "Invalid authorization token" }, 401);
    }

    await next();
  };
};
