# Frontend structure

- `customer/` — public menu and ordering pages opened from table or pickup QR codes.
- `staff/` — staff-only order receiving, counter POS, and staff login pages.
- `admin/` — admin-only management and admin login pages.

All three frontends share static assets from `public/` and call the same server API. The server keeps the existing public URLs so printed QR codes and saved bookmarks continue to work.
