# TestWorld ID System

Canonical patterns:

```
^(BRANCH|COMPANY|CUST|SUP|EMP|VEH|PRJ|DOCGROUP|DOCTYPE)-[0-9]{3}$
^DOC-[0-9]{5}$
```

| Prefix    | Entity       | Example       |
|-----------|--------------|---------------|
| BRANCH    | Branch (Standort) | BRANCH-001 |
| COMPANY   | Company      | COMPANY-001   |
| CUST      | Customer     | CUST-001      |
| SUP       | Counterparty | SUP-001       |
| EMP       | Employee     | EMP-001       |
| VEH       | Vehicle      | VEH-001       |
| PRJ       | Project      | PRJ-001       |
| DOC       | Document     | **DOC-00001** |
| DOCGROUP  | Document group (taxonomy) | DOCGROUP-001 |
| DOCTYPE   | Document leaf type (taxonomy) | DOCTYPE-006 |

**Document IDs use five digits** (`DOC-00001` … `DOC-99999`) so the world can grow past 999 documents without renumbering.

**Taxonomy freeze (02A):** `DOCGROUP-*`, `DOCTYPE-*`, `documentType`, `subtype` may only be **extended**, never renamed or removed.  
Registry: `../taxonomy/document-taxonomy.json`.

Rules: immutable after seed; no reuse; cross-refs by id only.  
Branch = Standort, never Gewerk — see `../README.md`.
