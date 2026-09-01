# User Story: Registration

**As a** new user,  
**I want to** create an account with a unique username, email, and password,  
**so that** I can access the platform and its features.

## API Example

### Request
`POST /auth/register`  

**Mandatory Headers**:
- `X-Client-ID`: The ID of the application agent.
- `X-Realm-ID`: The UUID of the security realm (domain) being joined.

**Optional Headers**:
- `X-Device-ID`: Unique identifier for the hardware/installation.

#### Request Body
```json
{
  "username": "johndoe",
  "email": "john@example.com",
  "password": "SecurePassword123!"
}
```

### Success Response
`200 OK`

The registration flow automatically records the user's presence in the requested realm.

```json
{
  "access_token": "v4.public....",
  "refresh_token": "uuid-v4-refresh-id"
}
```

### Error Response (Conflict)
`409 Conflict`

```json
{
  "error": "Username or email already exists"
}
```
