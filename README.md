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
| `DB_PATH` | no | SQLite path (defaults to `./data.sqlite`). |
| `DISCORD_WEBHOOK_URL` | no | Discord webhook for notifications (preferred). |
| `DISCORD_WEBHOOK` | no | Alias for `DISCORD_WEBHOOK_URL`. |
| `WEBHOOK_URL` | no | Alias for `DISCORD_WEBHOOK_URL`. |
| `DRY_RUN` | no | If `true`, RCON commands are logged instead of executed. |
| `PORT` | no | HTTP port (defaults to `8080`). |

Processed Tranzila transaction IDs are stored in `./data/processed.json` to prevent double grants.

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
- `product`: `product`, `sku`, `pdesc`, `plan`, `description`
- `amount`: `sum`, `amount`, `total`
- `status/approval`: `Response` (`000` approved) or `status` (`approved`, `ok`, `success`, or `0/00/000`)
- `txId`: `tx`, `txnId`, `transaction_id`, `tranId`, `transId`, `ConfirmationCode`, `index`, `orderid`, `orderId`, `id`, `Tempref`

Product mapping:
- `test-vip` / `test_vip` → `loverustvip.grant <steamid64> 10m`
- `vip_30` → `loverustvip.grant <steamid64> 30d`
- `rainbow_30` → `loverustvip.grant <steamid64> 30d` + `oxide.grant user <steamid64> vip.rainbow`

### Tranzila settings

Configure the Tranzila "Notify URL" to:
```
https://<your-domain>/tranzila/notify
```

Ensure Tranzila sends:
- `Response=000`
- `contact=<steamid64>`
- `sku=test-vip`
- `sum=0.01`
- `ConfirmationCode` or `index` (used as `txId`)

## Local test commands

### curl (JSON)
```bash
curl -X POST "http://localhost:8080/tranzila/notify?token=YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "Response": "000",
    "contact": "76561198000000000",
    "sku": "test-vip",
    "sum": "0.01",
    "ConfirmationCode": "tx-123"
  }'
```

### curl (form-urlencoded)
```bash
curl -X POST "http://localhost:8080/tranzila/notify?token=YOUR_SECRET" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "Response=000" \
  --data-urlencode "contact=76561198000000000" \
  --data-urlencode "sku=test_vip" \
  --data-urlencode "sum=0.01" \
  --data-urlencode "index=tx-456"
```

### PowerShell (JSON)
```powershell
$body = @{
  Response = "000"
  contact = "76561198000000000"
  sku = "test-vip"
  sum = "0.01"
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
  sku = "vip_30"
  sum = "1.00"
  index = "tx-987"
}

Invoke-RestMethod -Method Post `
  -Uri "http://localhost:8080/tranzila/notify?token=YOUR_SECRET" `
  -ContentType "application/x-www-form-urlencoded" `
  -Body $form
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
- `dayKey` is computed in UTC (`YYYY-MM-DD`).
- `peakToday` only updates on fresh RCON status fetches (not cached responses).

Manual test:
```bash
curl https://<railway-domain>/server/status
```

Example curl test:
```bash
curl http://localhost:8080/server/status | jq
```
