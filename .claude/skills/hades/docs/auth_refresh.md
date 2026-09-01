# User Story: Refresh Tokens

**As a** client application,  
**I want to** refresh my access token using a long-lived refresh token,  
**so that** the user can stay logged in without re-entering credentials.

## API Example

### Request
`POST /auth/refresh`  

**Mandatory Headers**:
- `X-Client-ID`: The ID of the application agent.
- `X-Realm-ID`: The UUID of the security realm (domain).

#### Request Body
```json
{
  "refresh_token": "uuid-v4-refresh-id"
}
```

### Success Response
`200 OK`

The new `access_token` will contain refreshed realm-specific permissions.

```json
{
  "access_token": "v4.public....",
  "refresh_token": "new-uuid-v4-refresh-id"
}
```

### Error Response (Unauthorized/Banned)
*   `400 Bad Request`: Missing mandatory headers or invalid client-realm association.
*   `401 Unauthorized`: Token is invalid, revoked, or expired.
*   `403 Forbidden`: User has been globally suspended.

```json
{
  "error": "Unauthorized"
}
```
