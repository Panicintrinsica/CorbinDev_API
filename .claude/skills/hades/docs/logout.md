# User Story: Logout

**As an** authenticated user,  
**I want to** log out of my session,  
**so that** my refresh token is invalidated and my account remains secure.

## API Example

### Request
`POST /auth/logout`

```json
{
  "refresh_token": "uuid-v4-refresh-id"
}
```

### Success Response
`200 OK`

```json
{}
```
