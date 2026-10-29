INSERT INTO "public_content_pages" (
  "id",
  "slug",
  "title",
  "subtitle",
  "body",
  "sections",
  "is_published",
  "created_at",
  "updated_at"
)
VALUES
  (
    gen_random_uuid(),
    'privacy-policy',
    'Privacy Policy',
    'How Finis collects, uses, and protects information.',
    '"<p>This privacy policy is managed by the Finis administrator. Please review the published points below.</p>"'::jsonb,
    '[]'::jsonb,
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    gen_random_uuid(),
    'terms-and-conditions',
    'Terms & Conditions',
    'The rules and responsibilities for using Finis.',
    '"<p>These terms are managed by the Finis administrator. Please review the published points below.</p>"'::jsonb,
    '[]'::jsonb,
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  )
ON CONFLICT ("slug") DO UPDATE
SET "is_published" = true,
    "updated_at" = CURRENT_TIMESTAMP;
