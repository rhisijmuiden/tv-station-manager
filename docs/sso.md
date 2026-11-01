# Sign in with Office 365 (Microsoft Entra ID)

*Nederlands: [sso.nl.md](sso.nl.md)*

The orchestrator and the management node can let people sign in with their Office 365 account. It uses OpenID Connect
(authorization code flow with PKCE and a client secret). Local accounts, including the local administrator, keep working
next to it, also when Microsoft cannot be reached.

## 1. HTTPS first

Microsoft only accepts `https://` redirect addresses (`http://localhost` is the only exception). Put each app behind a
reverse proxy with a certificate (see *Behind a reverse proxy* in the [README](../README.md)) before you start.

## 2. Create the app registration (once, for both apps)

In [entra.microsoft.com](https://entra.microsoft.com) → **Entra ID → App registrations → New registration**:

| Field | Value |
|---|---|
| Name | `TV Station Manager` |
| Supported account types | **Accounts in this organizational directory only (single tenant)** |
| Redirect URI | Platform **Web**, value: the *Redirect URI* shown on **System → Single sign-on** of the orchestrator, e.g. `https://orchestrator.example.com/api/auth/sso/callback` |

Then, in the new registration:

1. **Authentication → Web → Add URI**: add the redirect URI of the management node as well
   (e.g. `https://regie.example.com/api/auth/sso/callback`). Leave *Access tokens* and *ID tokens* (implicit grant) **off**.
2. **Certificates & secrets → Client secrets → New client secret**: description `TVSM`, expiry 24 months. Copy the
   **Value** straight away (it is shown only once). Put a reminder in your calendar to renew it before it expires.
3. **Overview**: copy the **Application (client) ID** and the **Directory (tenant) ID**.
4. **API permissions**: the default *Microsoft Graph → User.Read* is enough. Click **Grant admin consent** so users are not
   asked for consent.
5. *(optional)* **Token configuration → Add optional claim → ID → email**.

## 3. Roles (optional, recommended)

Without app roles every new Microsoft user gets the *Role for new accounts* (default: Operator), and you change roles on
the Users page. With app roles, Entra decides:

1. **App roles → Create app role**, three times (allowed member types: *Users/Groups*):

   | Display name | Value |
   |---|---|
   | Administrator | `TVSM.Admin` |
   | Editor-in-chief | `TVSM.Editor` |
   | Operator | `TVSM.Operator` |

2. **Enterprise applications → TV Station Manager → Users and groups → Add user/group**: assign people (or groups, needs
   Entra ID P1) to a role.
3. **Enterprise applications → TV Station Manager → Properties → Assignment required? = Yes**, so only assigned people
   can sign in.
4. In TVSM switch on **Take roles from Entra app roles**. The role is updated on every sign-in; people without a role are
   refused. The last administrator is never demoted by a sign-in.

## 4. Configure TVSM (on the orchestrator and on the management node)

**System → Single sign-on**:

1. Fill in *Directory (tenant) ID*, *Application (client) ID* and *Client secret*.
2. Check the *Redirect URI*. Behind a proxy that does not pass the right host, fill in *Public address of this app*.
3. **Test connection**: this checks tenant, client ID and secret against Microsoft.
4. Switch on **Enabled** and **Save**.

The login page now shows **Sign in with Microsoft**. *Sign in with a local account instead* opens the password form.

## Accounts

- Accounts are matched on the Microsoft object ID. The username is the Microsoft sign-in name (e.g. `jan@example.com`).
- *Create accounts automatically* off: add people on **System → Users** with sign-in **Microsoft (Office 365)** first.
- A local account with the same name is never taken over by a Microsoft sign-in.
- *Allowed e-mail domains* limits who may sign in, on top of the tenant.
- Microsoft accounts have no password in TVSM. Removing someone in Entra (or the assignment) stops new sign-ins; existing
  sessions end after 12 hours of inactivity, or delete the user on the Users page to end them at once.
