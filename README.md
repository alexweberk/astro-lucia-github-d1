# Setting up login using Lucia and Github with Astro

## Setting up the project

Set up the project by running the following commands:

```bash
npm create cloudflare@latest -- astro-cloudflare-lucia --framework=astro
```

Deploy and checkout the project online.

Now update packages.json so that we can do "npm run deploy" to deploy the project.

```json
"scripts": {
  ...,
  "deploy": "astro build && wrangler pages deploy ./dist",
  ...
}
```

Edit the src/pages/index.astro file a bit and run `npm run deploy` to see that changes are reflected in the deployed project.

### Minor setup

I edited my tsconfig.json paths to the following for convenience.

```json
{
  "extends": "astro/tsconfigs/strict",
  "compilerOptions": {
    "types": ["@cloudflare/workers-types", "drizzle-orm/d1"],
    "baseUrl": "./",
    "paths": {
      "@components/*": ["./src/components/*"],
      "@lib/*": ["./src/lib/*"],
      "@assets/*": ["./src/assets/*"],
      "@db/*": ["./src/db/*"]
    }
  }
}
```

## Add Cloudflare D1 Database

Create a new D1 database.

```bash
npx wrangler d1 create astro-cloudflare-lucia
```

Copy the resulting code and paste it into `wrangler.toml`. Create the file if it doesn't exist.

```toml
# wrangler.toml
name = "astro-cloudflare-lucia"
pages_build_output_dir = "./dist"

compatibility_flags = ["nodejs_compat"]
compatibility_date = "2024-09-23"

[[d1_databases]]
binding = "DB"                                       # i.e. available in your Worker on env.DB
database_name = "<<your database name>>"
database_id = "<<your database id>>"
```

Install Drizzle ORM and Drizzle Kit. We'll use it later.

```bash
npm i drizzle-orm
npm i -D drizzle-kit
```

## Setting up Github OAuth App

Now setup the Github OAuth App.

Go to [Github Developer Settings](https://github.com/settings/developers) and create a new OAuth App.
Click "New OAuth App" and enter details. Homepage URL can be your Cloudflare project URL. Authorization callback URL is your Cloudflare project URL + `/login/github/callback`.

You can get your Client ID and generate a new Client Secret. Copy them and paste it into your `.env` file.

```bash
# .env
GITHUB_CLIENT_ID="<<your client id>>"
GITHUB_CLIENT_SECRET="<<your client secret>>"
```

Also, login to Cloudflare and navigate to your project. Under "Settings > Variables and Secrets" add the above secrets there, too.

## Setting up Lucia

Lucia's docs are [here](https://lucia-auth.com/getting-started/astro) but they are hard to follow.

First step, paste middleware code in `src/middleware.ts`.

```ts
// src/middleware.ts
import { initializeLucia } from "@lib/auth";
import { defineMiddleware } from "astro:middleware";

export const onRequest = defineMiddleware(async (context, next) => {
  const lucia = initializeLucia(context.locals.runtime.env.DB);
  const sessionId = context.cookies.get(lucia.sessionCookieName)?.value ?? null;
  if (!sessionId) {
    context.locals.user = null;
    context.locals.session = null;
    return next();
  }

  const { session, user } = await lucia.validateSession(sessionId);
  if (session && session.fresh) {
    const sessionCookie = lucia.createSessionCookie(session.id);
    context.cookies.set(
      sessionCookie.name,
      sessionCookie.value,
      sessionCookie.attributes
    );
  }
  if (!session) {
    const sessionCookie = lucia.createBlankSessionCookie();
    context.cookies.set(
      sessionCookie.name,
      sessionCookie.value,
      sessionCookie.attributes
    );
  }
  context.locals.session = session;
  context.locals.user = user;
  return next();
});
```

Now install Drizzle ORM and Arctic.

```bash
npm i @lucia-auth/adapter-drizzle
npm i arctic
```

In `src/lib/auth.ts` add:

```ts
// src/lib/auth.ts
import { sessionTable, userTable } from "@db/schema";
import { DrizzleSQLiteAdapter } from "@lucia-auth/adapter-drizzle";
import { drizzle } from "drizzle-orm/d1";
import { Lucia } from "lucia";

import { GitHub } from "arctic";

export function initializeLucia(D1: D1Database) {
  const db = drizzle(D1);
  const adapter = new DrizzleSQLiteAdapter(db, sessionTable, userTable);

  return new Lucia(adapter, {
    sessionCookie: {
      attributes: {
        secure: false,
      },
    },
    getUserAttributes: (attributes: DatabaseUserAttributes) => {
      return {
        githubId: attributes.github_id,
        username: attributes.username,
      };
    },
  });
}

export function initializeGithubClient(env: Env) {
  return new GitHub(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET);
}

interface DatabaseUserAttributes {
  github_id: number;
  username: string;
}

declare module "lucia" {
  interface Register {
    Lucia: ReturnType<typeof initializeLucia>;
    DatabaseUserAttributes: DatabaseUserAttributes;
  }
}
```

Edit your `src/env.d.ts` file to the following:

```ts
// src/env.d.ts
/// <reference path="../.astro/types.d.ts" />

type D1Database = import("@cloudflare/workers-types").D1Database;
type Env = {
  DB: D1Database;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
};
type Runtime = import("@astrojs/cloudflare").Runtime<Env>;

declare namespace App {
  interface Locals extends Runtime {
    session: import("lucia").Session | null;
    user: import("lucia").User | null;
  }
}
```

## Setup Database Schema and Migrations

We'll setup the schema for database tables in `src/db/schema.ts`:

```ts
// src/db/schema.ts
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const userTable = sqliteTable("users", {
  id: text("id").notNull().primaryKey(),
  githubId: integer("github_id").unique(),
  username: text("username"),
});

export const sessionTable = sqliteTable("sessions", {
  id: text("id").notNull().primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => userTable.id),
  expiresAt: integer("expires_at").notNull(),
});
```

Now add the following scripts to `package.json` to generate and apply migrations, if you find them hard to remember.

```json
"scripts": {
  ...,
  "db:generate": "drizzle-kit generate --dialect=sqlite --schema=./src/db/schema.ts --out=./src/db/migrations",
  "db:migrate:local": "wrangler d1 migrations apply astro-cloudflare-lucia --local",
  "db:migrate:remote": "wrangler d1 migrations apply astro-cloudflare-lucia --remote",
  ...,
}
```

First run the `db:generate` script to generate your migration file. You will find files generated in the `src/db/migrations` folder.

Now run the `db:migrate:local` and `db:migrate:remote` scripts to apply the migration to your local D1 database and to the remote D1 database, respectively.

```bash
npm run db:migrate:local
npm run db:migrate:remote
```

Now your databases have your tables in them.

## Create login page and Login with Github API

Create `src/pages/login/index.astro` with the following:

```astro
---
// src/pages/login/index.astro
---
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1.0"
    />
    <title>Login</title>
  </head>
  <body>
    <h1>Login</h1>
    <a href="/login/github">Login with GitHub</a>
  </body>
</html>
```

And create `src/pages/login/github/index.ts` with the following:

```ts
// src/pages/login/github/index.ts
import { initializeGithubClient } from "@lib/auth";
import { generateState } from "arctic";

import type { APIContext } from "astro";

export async function GET(context: APIContext): Promise<Response> {
  const github = initializeGithubClient(context.locals.runtime.env);
  const state = generateState();
  const url = await github.createAuthorizationURL(state);

  context.cookies.set("github_oauth_state", state, {
    path: "/",
    secure: import.meta.env.PROD,
    httpOnly: true,
    maxAge: 60 * 10,
    sameSite: "lax",
  });

  return context.redirect(url.toString());
}
```

Then, create `src/pages/login/github/callback.ts` with the following:

```ts
// src/pages/login/github/callback.ts
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
```

## Create Logout API

Create `src/pages/logout.ts` with the following:

```ts
// src/pages/logout.ts
import { initializeLucia } from "@lib/auth";
import type { APIContext } from "astro";

export async function POST(context: APIContext): Promise<Response> {
  if (!context.locals.session) {
    return new Response(null, {
      status: 401,
    });
  }

  const lucia = initializeLucia(context.locals.runtime.env.DB);

  await lucia.invalidateSession(context.locals.session.id);

  const sessionCookie = lucia.createBlankSessionCookie();
  context.cookies.set(
    sessionCookie.name,
    sessionCookie.value,
    sessionCookie.attributes
  );

  return context.redirect("/login");
}
```

## Modify the Home Page

Let's tie it together by modifying the home page with the following:

```astro
---
// src/pages/index.astro
import Layout from "../layouts/Layout.astro";
const now = new Date();

// We can now get the user object from Astro.locals if the user is logged in.
const { user } = Astro.locals;
---

<Layout title="Welcome to Astro.">
  <main>
    <h1>Welcome to Astro.</h1>
    <p>The current time is {now.toLocaleTimeString()}.</p>
    {
      user ? (
        <div>
          <p>You are logged in as {JSON.stringify(user)}.</p>
          <form
            action="/logout"
            method="post"
          >
            <button type="submit">Logout</button>
          </form>
        </div>
      ) : (
        <a href="/login">Login</a>
      )
    }
  </main>
</Layout>
```

## Deploy the Project

```bash
npm run deploy
```

Now you can navigate to the project and test it out. You should be able to login with Github and see the user object in the home page. You should also be able to logout.

## Conclusion

So this was the summary of the steps to setup login with Github using Lucia and Astro. There are other providers you can use, too.

I found the docs for Lucia and Arctic hard to follow, so I hope this helps others who are trying to do the same.

Enormous thanks to this YouTube video: [YouTube Video](https://www.youtube.com/watch?v=urAHMyBXM6k)
