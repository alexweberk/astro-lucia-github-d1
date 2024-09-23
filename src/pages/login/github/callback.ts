import { userTable } from "@db/schema";
import { initializeGithubClient, initializeLucia } from "@lib/auth";
import { OAuth2RequestError } from "arctic";
import type { APIContext } from "astro";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { generateIdFromEntropySize } from "lucia";

export async function GET(context: APIContext): Promise<Response> {
  const github = initializeGithubClient(context.locals.runtime.env);
  const lucia = initializeLucia(context.locals.runtime.env.DB);
  const db = drizzle(context.locals.runtime.env.DB);

  const code = context.url.searchParams.get("code");
  const state = context.url.searchParams.get("state");
  const storedState = context.cookies.get("github_oauth_state")?.value ?? null;
  if (!code || !state || !storedState || state !== storedState) {
    return new Response(null, {
      status: 400,
    });
  }

  try {
    const tokens = await github.validateAuthorizationCode(code);
    const githubUserResponse = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "User-Agent": "astro-cloudflare-lucia",
      },
    });
    const githubUser: GitHubUser = await githubUserResponse.json();

    // Replace this with your own DB client.
    const existingUser = await db
      .select()
      .from(userTable)
      .where(eq(userTable.githubId, Number(githubUser.id)))
      .get();

    if (existingUser) {
      const session = await lucia.createSession(existingUser.id, {});
      const sessionCookie = lucia.createSessionCookie(session.id);
      context.cookies.set(
        sessionCookie.name,
        sessionCookie.value,
        sessionCookie.attributes
      );
      return context.redirect("/");
    }

    const userId = generateIdFromEntropySize(10); // 16 characters long

    // Replace this with your own DB client.
    await db.insert(userTable).values({
      id: userId,
      githubId: Number(githubUser.id),
      username: githubUser.login,
    });

    const session = await lucia.createSession(userId, {});
    const sessionCookie = lucia.createSessionCookie(session.id);
    context.cookies.set(
      sessionCookie.name,
      sessionCookie.value,
      sessionCookie.attributes
    );
    return context.redirect("/");
  } catch (e) {
    // the specific error message depends on the provider
    if (e instanceof OAuth2RequestError) {
      // invalid code
      return new Response(null, {
        status: 400,
      });
    }
    return new Response(null, {
      status: 500,
    });
  }
}

interface GitHubUser {
  id: string;
  login: string;
}
