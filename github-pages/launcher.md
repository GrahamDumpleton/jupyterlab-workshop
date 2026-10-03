# Workshop launcher

This JupyterLite site carries no workshops of its own. It opens a
workshop named by a launch link, so a link such as

```
.../lab/index.html?reset&workshop=https://gist.github.com/<owner>/<id>&restart=force
```

fetches that workshop into the browser and starts it. The Python the
site provides is fixed by its address, so a link keeps working as it
was written when newer sites are published alongside.

See the [documentation](https://jupyterlab-workshop.readthedocs.io/en/latest/publishing.html#a-workshop-in-a-gist)
for publishing a workshop that opens here.
