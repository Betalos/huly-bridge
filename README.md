# huly-bridge

Small plain-HTTP REST bridge to [Huly](https://github.com/hcengineering/platform), for n8n or any HTTP client.
Huly has no REST API or webhooks; this wraps `@hcengineering/api-client`.

## Run

```bash
docker run -p 8080:8080 -e HULY_URL=https://huly.example.com -e HULY_WORKSPACE=myworkspace ghcr.io/<owner>/huly-bridge:latest
```

| Env | |
|---|---|
| `HULY_URL` | required, your Huly front URL |
| `HULY_WORKSPACE` | workspace URL name passed to the Huly client (the token decides the workspace) |
| `READY_STATUS` / `READY_LABEL` | what `/issues/ready` treats as ready (default `Ready` / `ready`) |
| `PORT` | default `8080` |

## Auth

The bridge stores no credentials. Each request carries the caller's Huly token:

```
Authorization: Bearer <Huly workspace token>
```

Huly validates the token, so a different token = a different Huly user (comments show the right author).
In n8n send it as a Header Auth credential per agent (name `Authorization`, value `Bearer <token>`).
The server speaks plain HTTP: keep it on a private network or put TLS in front, since tokens are in the headers.

## Routes

`GET /health` (no auth), `GET /me`, `/capabilities`, `/projects`, `/activity/last`, `/issues`, `/issues/ready`,
`GET|PATCH /issues/:ID`, `POST /issues`, `POST /issues/:ID/labels`, `POST /issues/:ID/comments`.
Issue comments include `byMe`: true when the calling token wrote it (use `/me` for the full list of the caller's social ids).

## Releases

Pushes to `main` publish `ghcr.io/<owner>/huly-bridge:latest` and `:sha-…`; tags `v1.2.3` publish `1.2.3` and `1.2`.
