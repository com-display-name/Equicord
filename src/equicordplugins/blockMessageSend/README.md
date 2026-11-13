# BlockMessageSend

Blocks Discord API requests to message endpoints, preventing you from sending messages.

Requests are matched against `https://discord.com/api/v*/channels/*/messages` (and the
individual message endpoints used for editing or deleting). Both `fetch` and Discord's
internal `RestAPI` are intercepted, so blocked requests never leave your client.

## Settings

- **Block mode**
  - *Sending messages only* (default): blocks `POST` requests used to send messages.
  - *Sending, editing and deleting messages*: also blocks `PATCH` and `DELETE` requests.
  - *All requests, including loading messages*: blocks every request to these endpoints.
    This means message history will no longer load.
- **Show a notification when a request is blocked**: shows a toast when a request is blocked.
