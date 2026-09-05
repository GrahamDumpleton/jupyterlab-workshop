---
title: Variables and tracks
---

# Variables and tracks

Variables appear in text and in actions. Your name is {var}`learner`; change
it with the gear icon in the panel header and this page updates.

A choice records a value. This one also picks a track, which decides which
of the next pages you see.

```{choice}
:track: true
Which package manager do you use?
```

```{when} track == "pip"
You chose pip. The next page is about pip.
```

```{when} track == "conda"
You chose conda. The next page is about conda.
```

A dialog can ask a question and store the answer.

```{dialog}
:title: Quick check
:buttons: great, fine, tired
:capture: mood
How are you feeling today?
```

```{when} mood
You said you are feeling {var}`mood`.
```

Workshops can set variables directly too.

```{env-set}
:name: greeting
Hello from the workshop
```

Variables are also exported to terminals as environment variables.

```{execute}
:session: shell
echo "$GREETING for $LEARNER on $WORKSHOP_PLATFORM"
```
