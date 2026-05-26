# Clip Plan Format

ShortClipper accepts human-readable plans like:

```text
Short 1 - Principles Guide Action

Suggested title:
Do Your Beliefs Actually Produce Good Results?

Use these pieces:

Hook
00:00:55:15 - 00:01:01:03
"The question I'm kind of asking myself here is, what are the principles?"

Main point
00:01:01:06 - 00:01:16:13
"Principles guide action. Action leads to results..."
```

It also accepts JSON:

```json
{
  "shorts": [
    {
      "number": 1,
      "title": "Do Your Beliefs Actually Produce Good Results?",
      "segments": [
        {
          "label": "Hook",
          "required": true,
          "start": "00:00:55:15",
          "end": "00:01:01:03",
          "excerpt": "The question I'm kind of asking myself here is, what are the principles?"
        }
      ]
    }
  ]
}
```
