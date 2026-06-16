/* cloud-config.js — paste your Supabase project values here to enable online
   accounts + cloud saves. Leave them blank to keep the game fully local/offline
   (guest mode). See docs/CLOUD_SETUP.md for the 5-minute setup.

   NOTE: the "anon" key is a PUBLIC, publishable key — it is meant to ship in
   client code. Your data is protected by Row-Level Security (the SQL in the
   setup doc), NOT by hiding this key. Never put the service_role key here.      */
window.CLOUD = {
  url: "https://okqopvfxsexuoxlsnxtc.supabase.co",      // e.g. "https://abcdefghijklmnop.supabase.co"
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9rcW9wdmZ4c2V4dW94bHNueHRjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1Njk2NDksImV4cCI6MjA5NzE0NTY0OX0.LrLVOjAAMCDQIn7Qr99-w7s93E06xHMAjNr1w4gr76Y",  // the project's anon / public key
};
