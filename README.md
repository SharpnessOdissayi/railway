# LoveRust Pay Bridge (Backend)

This service receives Tranzila notify calls and grants VIP via Rust RCON. It supports both JSON and `application/x-www-form-urlencoded` payloads.

## Environment variables

| Name | Required | Description |
| --- | --- | --- |
| `API_SECRET` | yes | Shared secret for legacy endpoints (required at boot). |
| `TRAZNILA_NOTIFY_SECRET` | no | If set, `/tranzila/notify` requires this token. |
| `RCON_HOST` | yes | Rust RCON host. |
| `RCON_PORT` | yes | Rust RCON port. |
| `RCON_PASSWORD` | yes | Rust RCON password. |
| `BESTSERVERS_SERVERKEY` | yes | BestServers API server key for vote claim verification. |
| `REFERRAL_API_TOKEN` | yes | Shared bearer token for referral plugin → backend calls (preferred). |
| `REFERRAL_SERVER_SECRET` | yes | Legacy shared secret for referral server-to-backend calls (fallback if `REFERRAL_API_TOKEN` is unset). |
| `SESSION_SIGNING_SECRET` | yes | HMAC secret for short-lived refcode session JWTs (preferred). |
| `REFCODE_SESSION_SECRET` | no | Legacy alias for `SESSION_SIGNING_SECRET`. |
| `DB_PATH` | no | SQLite path (defaults to `./data.sqlite`). |
| `DISCORD_WEBHOOK_URL` | no | Discord webhook for notifications (preferred). |
| `DISCORD_WEBHOOK` | no | Alias for `DISCORD_WEBHOOK_URL`. |
| `WEBHOOK_URL` | no | Alias for `DISCORD_WEBHOOK_URL`. |
| `DRY_RUN` | no | If `true`, RCON commands are logged instead of executed. |
| `TEST_TARGET` | no | For `sku=test`, route to `vip_30d` or `rainbow_30d` (required for test grants). |
| `VOLUME_PATH` | no | Persistent volume directory for `peak.json` (defaults to `/data` if present). |
| `PORT` | no | HTTP port (defaults to `8080`). |

Processed Tranzila transaction IDs are tracked in-memory for 24 hours to prevent double grants.

## Discord Webhook

The service can send Discord notifications after a successful Tranzila notify + VIP grant. Configure **one** of the following environment variables (first non-empty wins):

- `DISCORD_WEBHOOK_URL` (preferred)
- `DISCORD_WEBHOOK`
- `WEBHOOK_URL`

### Debug test endpoint

You can trigger a test webhook message with:

```
GET /debug/test-discord?token=YOUR_SECRET
```

The `token` must match the same `TRAZNILA_NOTIFY_SECRET` used for `/tranzila/notify`.

## Tranzila notify endpoint

`POST /tranzila/notify`

Supported content types:
- `application/json`
- `application/x-www-form-urlencoded`

Field normalization:
- `steamid64`: `steamid64`, `contact`, `steam_id`, `steamId`, `custom1`
- `product` priority: `custom2`, then `pdesc`, then `product`/`sku`
- `amount`: `sum`, `amount`, `total`
- `status/approval`: `Response` (`000` approved) or `status` (`approved`, `ok`, `success`, or `0/00/000`)
- `txId`: `ConfirmationCode`, `Tempref`, `txnId`, `transaction_id`, `tranId`, `transId`, `tx`, `index`, `orderid`, `orderId`, `id`

Product mapping:
- `vip_30d` → `oxide.grant user <steamid64> loverustvip.use` + `oxide.grant user <steamid64> vipwall.use`
- `rainbow_30d` → `loverustvip.grantrainbow <steamid64> 30d`
- `test` → `TEST_TARGET` (must be `vip_30d` or `rainbow_30d`)

### Tranzila settings

Configure the Tranzila "Notify URL" to:
```
https://<your-domain>/tranzila/notify
```

Ensure Tranzila sends:
- `Response=000`
- `contact=<steamid64>`
- `custom2=vip_30d` (or `custom2=rainbow_30d`)
- `sum=19.90` (VIP 30d) or `sum=9.90` (Rainbow 30d)
- `ConfirmationCode` or `index` (used as `txId`)

### Railway env var

Set `TEST_TARGET` in Railway to `vip_30d` or `rainbow_30d` to control how `sku=test` is routed.

## BestServers vote postback

Configure BestServers to send votes to:
```
https://railway-production-9e24.up.railway.app/bestservers/postback
```

Postbacks trigger a server-side verification + claim call to the BestServers API before rewards are granted.

Vote link format (pass the SteamID64 as the `USERNAME OR KEY`):
```
https://bestservers.com/server/{id}/vote/{STEAMID64}
```

Manual test example:
```
https://railway-production-9e24.up.railway.app/bestservers/postback?username=76561198000000000&userip=127.0.0.1
```

## Referral system

The referral system supports a friend-brings-friend program. The backend is the source of truth, and plugin calls must include `Authorization: Bearer $REFERRAL_API_TOKEN` (or the legacy `REFERRAL_SERVER_SECRET`).

Rules summary:
- 5 verified referrals required.
- Each referred player needs >= 24 hours playtime and >= 7 days since first join.
- Verification requires mutual acceptance (referred confirms).
- Reward: $10 Steam Gift Card.

Flow overview:
1. Website calls `POST /api/referrals/request` with `{ referrerId, referredId }` to create a pending referral and receive a 6-character code.
2. Trusted server calls `POST /api/referrals/accept` with `{ referrerId, referredId, acceptedBy: "referred" }` (or `{ referredId, code }`) to confirm the referral.
3. Trusted server calls `POST /api/referrals/verify` with `{ referredId, totalPlaySeconds, firstSeenAt }` to mark verified once playtime is at least 86,400 seconds and first join was at least 7 days ago.
4. `GET /api/referrals/status?steamid64=...` returns referrer/referred status, verification counts, and eligibility (eligible at 5 verified referrals).

### Ref Dashboard without Steam login (refcode flow)

1. Plugin issues a short-lived 4-digit code:
`POST /api/refcode/issue` with `{ steamid64, displayName }` (expires in 5 minutes).
2. Website consumes the code (no secrets) via `POST /api/refcode/consume` and receives a short-lived session token (10 minutes).
3. Website calls `GET /api/referrals/me` with `Authorization: Bearer <token>` to fetch status for the logged-in player.
4. Website can fetch rules from `GET /api/referrals/rules`.

## Local test commands

### curl (JSON)
```bash
curl -X POST "http://localhost:8080/tranzila/notify?token=YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "Response": "000",
    "contact": "76561198000000000",
    "custom2": "vip_30d",
    "sum": "19.90",
    "ConfirmationCode": "tx-123"
  }'
```

### curl (form-urlencoded)
```bash
curl -X POST "http://localhost:8080/tranzila/notify?token=YOUR_SECRET" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "Response=000" \
  --data-urlencode "contact=76561198000000000" \
  --data-urlencode "custom2=rainbow_30d" \
  --data-urlencode "sum=9.90" \
  --data-urlencode "index=tx-456"
```

### PowerShell (JSON)
```powershell
$body = @{
  Response = "000"
  contact = "76561198000000000"
  custom2 = "vip_30d"
  sum = "19.90"
  ConfirmationCode = "tx-789"
} | ConvertTo-Json

Invoke-RestMethod -Method Post `
  -Uri "http://localhost:8080/tranzila/notify?token=YOUR_SECRET" `
  -ContentType "application/json" `
  -Body $body
```

### PowerShell (form-urlencoded)
```powershell
$form = @{
  Response = "000"
  contact = "76561198000000000"
  custom2 = "vip_30d"
  sum = "19.90"
  index = "tx-987"
}

Invoke-RestMethod -Method Post `
  -Uri "http://localhost:8080/tranzila/notify?token=YOUR_SECRET" `
  -ContentType "application/x-www-form-urlencoded" `
  -Body $form
```

## Acceptance tests (curl)

### Rainbow 30d only
```bash
curl -X POST "http://localhost:8080/tranzila/notify?token=YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "Response": "000",
    "contact": "76561198000000000",
    "custom2": "rainbow_30d",
    "ConfirmationCode": "tx-rainbow-1"
  }'
```

### VIP 30d only
```bash
curl -X POST "http://localhost:8080/tranzila/notify?token=YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "Response": "000",
    "contact": "76561198000000000",
    "custom2": "vip_30d",
    "ConfirmationCode": "tx-vip-1"
  }'
```

### TEST_TARGET routed to rainbow
```bash
TEST_TARGET=rainbow_30d \
curl -X POST "http://localhost:8080/tranzila/notify?token=YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "Response": "000",
    "contact": "76561198000000000",
    "custom2": "test",
    "ConfirmationCode": "tx-test-1"
  }'
```

### Deduped transaction
```bash
curl -X POST "http://localhost:8080/tranzila/notify?token=YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "Response": "000",
    "contact": "76561198000000000",
    "custom2": "vip_30d",
    "ConfirmationCode": "tx-vip-1"
  }'
```

## Refcode flow (curl)

### Issue a refcode (plugin)
```bash
curl -X POST "http://localhost:8080/api/refcode/issue" \
  -H "Authorization: Bearer $REFERRAL_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"steamid64":"76561198000000000","displayName":"Referrer"}'
```

### Consume refcode (website)
```bash
curl -X POST "http://localhost:8080/api/refcode/consume" \
  -H "Content-Type: application/json" \
  -d '{"code":"1234"}'
```

### Fetch referral status (website)
```bash
curl -X GET "http://localhost:8080/api/referrals/me" \
  -H "Authorization: Bearer <SESSION_TOKEN>"
```

### Accept + verify referral (plugin)
```bash
curl -X POST "http://localhost:8080/api/referrals/accept" \
  -H "Authorization: Bearer $REFERRAL_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"referrerId":"76561198000000000","referredId":"76561198000000001","acceptedBy":"referred"}'

curl -X POST "http://localhost:8080/api/referrals/verify" \
  -H "Authorization: Bearer $REFERRAL_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"referredId":"76561198000000001","totalPlaySeconds":90000,"firstSeenAt":"2024-01-01T00:00:00.000Z"}'
```

## Server status endpoint

`GET /server/status`

Returns the live Rust player count from RCON (cached for ~10 seconds).

Example response:
```json
{
  "ok": true,
  "online": 42,
  "max": 200,
  "peakToday": 87,
  "peakTodayUpdatedAt": "2026-01-22T10:15:30.123Z",
  "dayKey": "2026-01-22",
  "updatedAt": "2026-01-22T10:15:30.123Z",
  "raw": "players : 42/200 (200 max)"
}
```

Notes:
- Day boundaries are computed in `Asia/Jerusalem` with a start time of `05:00` local time.
- `peakToday` is floored to `10` for display (internal tracking still uses the real peak).
- To persist peak across deploys, mount a volume and set `VOLUME_PATH=/data` (or rely on auto-detection of `/data`).
- `peakToday` only updates on fresh RCON status fetches (not cached responses).

Manual test:
```bash
curl https://<railway-domain>/server/status
```

Example curl test:
```bash
curl http://localhost:8080/server/status | jq
```
