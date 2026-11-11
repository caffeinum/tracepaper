# tracepaper cloud

a published canvas. not the local bun server.

## resources

one worker, `tracepaper`. two sqlite durable objects:

- `Canvas`, one per canvas slug. holds the frame html, the last 8 html revisions per frame, and an empty comments table.
- `Registry`, one instance named `registry`. lists the canvases.

no d1, kv, r2, or queues.

## secret

`PUBLISH_TOKEN`. writes return 501 until it is set. reads stay public. the token is a bearer token, never a query param.

```
npx wrangler secret put PUBLISH_TOKEN
```

## deploy

from this directory, logged into the account that should own it:

```
npx wrangler deploy
```

do not set `account_id` in wrangler.jsonc. the logged-in account is the target.

## publish

```
curl -X PUT https://<worker>/api/canvases/<slug> \
  -H "authorization: Bearer $PUBLISH_TOKEN" \
  -H "content-type: application/json" \
  -d '{"name":"Evals","frames":[{"id":"frm_0123456789ab","name":"Shot","html":"<h1>hi</h1>","width":800,"height":600,"x":0,"y":0,"kind":"html","fontSize":null}]}'
```

the slug is lowercase, `[a-z0-9-]`, 1–63 chars. a frame id is `frm_` plus 12 hex, the same ids the local app uses.

viewers open `/c/<slug>`. html frames load in a sandboxed iframe (`allow-scripts allow-forms`, no `allow-same-origin`) from `/c/<slug>/f/<frameId>`, which also sends a sandbox CSP. that document cannot read the viewer page. a later split onto its own workers.dev host is still the stronger box.
