-- Grant the application role only the table operations used by Arc token
-- issuance, its read model, and the gated infrastructure workers.
-- These tables use UUID-generated identifiers and require no sequence access.

GRANT SELECT, INSERT, UPDATE ON TABLE
  public.arc_currency_genesis_requirements,
  public.arc_token_pilot_capabilities,
  public.arc_token_issuance_intents,
  public.arc_token_issuance_responses,
  public.arc_token_issuance_issuer_candidates,
  public.arc_agent_tokens,
  public.arc_agent_token_responses,
  public.arc_mainnet_pilot_cost_reservations,
  public.arc_infrastructure_nonce_cursors,
  public.arc_infrastructure_nonce_reservations
TO synterra_app;

GRANT SELECT, INSERT ON TABLE
  public.arc_token_issuance_decisions,
  public.arc_agent_token_uses
TO synterra_app;

GRANT SELECT, UPDATE ON TABLE public.arc_mainnet_pilot_budget TO synterra_app;

-- The decision and usage records are append-only from the runtime. The
-- singleton budget row and Arc submission state are updated in place.
-- No runtime path needs DELETE or sequence privileges.
