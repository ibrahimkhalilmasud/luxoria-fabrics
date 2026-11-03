// Supabase Edge Function entry point. All logic lives in handler.ts.
import { createHandler, readEnv } from "./handler.ts";

Deno.serve(createHandler(readEnv((k) => Deno.env.get(k))));
