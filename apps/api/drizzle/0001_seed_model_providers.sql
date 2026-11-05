-- Reference data: LLM providers known to TraceMind. Prices live in model_pricing and are
-- maintained separately (they change often and must carry an effective date and source).
INSERT INTO "model_providers" ("id", "display_name") VALUES
  ('openai', 'OpenAI'),
  ('anthropic', 'Anthropic'),
  ('google', 'Google Gemini'),
  ('custom', 'Custom / self-hosted')
ON CONFLICT ("id") DO NOTHING;
