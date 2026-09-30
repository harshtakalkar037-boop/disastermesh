# HTTP API

Base path `/api/v1`. All responses include `X-DisasterMesh-Prototype: not-a-certified-emergency-service`.

| Method | Path | Who |
| --- | --- | --- |
| GET | `/health` | public |
| POST | `/auth/login` | public, rate limited |
| GET | `/auth/me` | any signed-in role |
| GET | `/dashboard/summary` | operator, responder, publisher, admin |
| GET | `/incidents` | operator, responder, admin |
| PATCH | `/incidents/:id` | operator, admin |
| POST | `/incidents/:id/ack` | operator, admin |
| POST | `/incidents/:id/assign` | operator, admin |
| GET | `/groups` | operator, responder, admin |
| POST | `/groups/manual-merge` | operator, admin |
| GET/POST/PATCH | `/teams` | create: operator/admin; status: responder only for own team |
| GET/POST | `/alerts` | official kind: admin plus confirmation phrase |
| GET | `/alerts/official-feed` | reports that no government feed is configured |
| GET | `/timeline` | operator, responder, admin |
| GET | `/connectivity` | operator, admin. No coverage claim. |
| GET | `/unknown-zones` | operator, admin |
| GET | `/analytics` | operator, admin |
| GET/POST | `/users` | admin |
| POST | `/sync/packets` | signed packets, live flag required |
| POST | `/sync/acks` | signed poll |
| POST | `/sync/photo` | multipart, 4 MB |
| POST | `/ai/extract` | operator, admin. Does not persist an alert. |
| POST | `/ai/suggest` | duplicate and contradiction hints |
| POST | `/simulator/run` | operator, admin. Max 1,000 nodes. Separate from live counts. |
| POST | `/admin/reset-demo` | admin, confirmation header and body |
| GET | `/live` | WebSocket. First message `{ "type": "auth", "token": "..." }`. |

Live dashboard queries use `simulated = false`. Pass `includeSimulated=1` only when you intend to read the simulator partition.
