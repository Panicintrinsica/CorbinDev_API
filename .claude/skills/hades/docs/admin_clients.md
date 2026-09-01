# User Story: Client Management (Admin)

**As a** superadmin,  
**I want to** register and list applications (clients) allowed to use the identity provider,  
**so that** I can control which projects have access to the global user registry.

## API Example

### 1. Register Client
`POST /admin/clients`  
**Header**: `Authorization: Bearer <superadmin_access_token>`

#### Request
Clients must be associated with a valid **Realm ID** (UUID). The server will automatically generate a UUID for the client.

```json
{
  "realm_id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "Guildhall Web App"
}
```

#### Success Response
`200 OK`

```json
{
  "_id": "00000000-0000-0000-0000-000000000001",
  "realm_id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "Guildhall Web App",
  "created_at": "2026-05-10T14:00:00Z"
}
```

### 2. List Clients
`GET /admin/clients`  
**Header**: `Authorization: Bearer <superadmin_access_token>`

#### Success Response
`200 OK`

```json
[
  {
    "_id": "guildhall_web",
    "realm_id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "Guildhall Web App",
    "created_at": "2026-05-10T14:00:00Z"
  }
]
```
