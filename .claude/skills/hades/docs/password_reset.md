# User Story: Password Reset Request

**As a** user who has forgotten my password,  
**I want to** request a password reset via my email,  
**so that** I can regain access to my account.

## API Example

### Request
`POST /auth/reset-password`

```json
{
  "email": "john@example.com"
}
```

### Success Response
`200 OK`  
*(Note: Always returns 200 to prevent email enumeration)*

```json
{}
```
