# Durable routing and delivery

## Failure modes addressed

The prototype kept the iLink cursor, context tokens, duplicate ids, and chat mappings in memory. Restarting could replay updates and always created a new Harness session. It also advanced its delivery cursor before Weixin accepted a response, so a transient send failure lost that answer.

## Decisions

- Store non-secret gateway state in `$DSH_HOME/weixin/gateway-state.json` with the same atomic, private-file writer used for credentials.
- Persist the iLink poll cursor before processing returned messages. Context tokens and the bounded duplicate-id set use the same state file.
- Store chat-to-session ids and lazily resume a session on the next inbound message. If Harness persistence no longer has that session, log the failure and replace the mapping with a fresh session.
- Flush the Harness session at `turn/end` before sending its answer.
- Serialize answer delivery per chat. Retry transient send failures until shutdown and advance the delivery sequence only after every chunk succeeds.
- Split long answers by Unicode code points. The default chunk size is 3,500 characters and can be changed through plugin configuration.

## Limits

The state writer protects against torn files and in-process write races. It does not support two dsh-weixin processes sharing one state file. A deployment must run one gateway per Weixin account and state path.
