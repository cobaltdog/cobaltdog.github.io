# Tray setup (Supabase Storage)

GitHub Pages only serves static files, so the tray stores files in a free Supabase project.

1. Create a project at https://supabase.com (free plan is fine).
2. Open **SQL Editor** and run:

```sql
-- Private bucket, 100 MB per-file ceiling (free plan caps single files at 50 MB)
insert into storage.buckets (id, name, public, file_size_limit)
values ('tray', 'tray', false, 104857600)
on conflict (id) do nothing;

create policy "tray read"   on storage.objects for select to anon using (bucket_id = 'tray');
create policy "tray insert" on storage.objects for insert to anon with check (bucket_id = 'tray');
create policy "tray delete" on storage.objects for delete to anon using (bucket_id = 'tray');
```

3. Go to **Project Settings → API**, copy the Project URL and the `anon` public key into `assets/config.js`.
4. Commit and push.

## Limits and how they're enforced
- 5 items / 100 MB total: enforced in the browser. Before an upload, the oldest files are removed until the new one fits.
- 100 MB per file: enforced by the bucket's `file_size_limit`. On the Supabase free plan the global per-file cap is 50 MB.
- The password (`123`) is a client-side gate only. Anyone who reads the page source can reach the bucket with the anon key.
