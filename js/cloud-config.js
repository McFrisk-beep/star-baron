/* cloud-config.js — paste your Supabase project values here to enable online
   accounts + cloud saves. Leave them blank to keep the game fully local/offline
   (guest mode). See docs/CLOUD_SETUP.md for the 5-minute setup.

   NOTE: the "anon" key is a PUBLIC, publishable key — it is meant to ship in
   client code. Your data is protected by Row-Level Security (the SQL in the
   setup doc), NOT by hiding this key. Never put the service_role key here.      */
window.CLOUD = {
  url: "",      // e.g. "https://abcdefghijklmnop.supabase.co"
  anonKey: "",  // the project's anon / public key
};
