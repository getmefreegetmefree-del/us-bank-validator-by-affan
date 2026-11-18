# data/

Optional reference data loaded by the server at startup. Nothing users submit is ever written here.

| File | Purpose |
|---|---|
| `FedACHdir.txt` or `FedACHdir.json` | Federal Reserve FedACH Participant Directory. Turns on bank identification and authoritative ACH eligibility. **Not included** because the Fed's terms don't allow redistributing it. See the main README for how to get it. |
| `institution-rules.json` | Optional account-number length rules per bank. Only add rules you can cite. See `institution-rules.example.json`. |

Both files are git-ignored so they don't end up in a public repo by accident.
