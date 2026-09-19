// =============================================
// AutoFlow Pro — Konfigürasyon
// Yayınlamadan önce kendi değerlerinizi girin
// =============================================
const AUTOFLOW_CONFIG = {
  SUPABASE_URL: 'https://fuuaamcndahndmdbpcnl.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ1dWFhbWNuZGFobmRtZGJwY25sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4MDkxMzAsImV4cCI6MjA5NTM4NTEzMH0.3fvj2ig4658BWZCWPdSm_PxOnRUiE1alNechdRVkPdc',
  STRIPE_PAYMENT_LINK: 'https://buy.stripe.com/8x29AU7zWedN7Ec6H4ebu01',
  FREE_DAILY_LIMIT: 20,

  // true  = herkese ücretsiz/sınırsız (ödeme gizli). Lansman için böyle bırak.
  // false = ücretli mod: günlük limit + "Pro'ya Geç" + Stripe aktif.
  // İleride ücrete geçmek için tek yapman gereken: bunu false yapıp yeniden yayınlamak.
  FREE_MODE: true
};
