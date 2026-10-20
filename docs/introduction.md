# Introduction

Contract owner: Core architecture.

Progressive CMS separates structured content, revisions and publication from theme rendering. Web serves public pages and API; Worker processes jobs and outbox events; CLI supports local operator tasks and authenticated API workflows. PostgreSQL persists application state. Media files need persistent storage independently of the immutable release.

A theme defines presentation. Content Types define the stored fields. Extensions contribute through a trusted deployment composition. Agent Skills guide clients through existing contracts; they do not grant permissions or install runtime features.

Start with [Requirements](requirements.md), [Installation](installation.md) and [First Site](first-site.md).

[Documentation index](index.md)
