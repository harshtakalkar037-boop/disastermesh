# Release checklist

- [ ] `npm test` passes on a clean checkout.
- [ ] Command-center production build succeeds.
- [ ] `JWT_SECRET` and `POSTGRES_PASSWORD` are real secrets, not the examples.
- [ ] `DM_ALLOW_PGLITE` is unset in production. `DATABASE_URL` points at PostgreSQL.
- [ ] TLS is terminated or `TLS_CERT` / `TLS_KEY` are set. Phones are not pointed at cleartext.
- [ ] `SEED_USE_DEV_DEFAULTS` is unset.
- [ ] `ALLOW_DEMO_RESET` is unset unless a demo host intentionally needs it.
- [ ] Android CI uploaded an APK, or you built one locally and recorded the checksum.
- [ ] Three-phone plan is either filled with observed results or still marked NOT RUN.
- [ ] README limitations still match the build. No simulated metric is labeled as a device measurement.
- [ ] No real personal emergency data is in the git history.
- [ ] Hackathon submission, if any, follows `docs/HACKATHON_COMPLIANCE.md`.
