-- Deleting library documents moves from `library:write` to its own `library:delete` scope, so a
-- connection that saves to the library cannot also delete from it unless the user approved that.
-- API keys are made by their owner, who chose "save and delete" when `library:write` meant both:
-- every existing key holding `library:write` also gets `library:delete`, so its access is unchanged.
-- OAuth grants are not migrated; their clients re-authorize (step-up) to delete.
-- Safe for the previous Worker version: it drops scopes the role does not list (capScopes).
UPDATE api_keys
SET scopes = json_insert(scopes, '$[#]', 'library:delete')
WHERE json_valid(scopes)
  AND EXISTS (SELECT 1 FROM json_each(api_keys.scopes) WHERE value = 'library:write')
  AND NOT EXISTS (SELECT 1 FROM json_each(api_keys.scopes) WHERE value = 'library:delete');
