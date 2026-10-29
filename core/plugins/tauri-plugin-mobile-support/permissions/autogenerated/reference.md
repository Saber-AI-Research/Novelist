## Default Permission

Allows the webview to open the native share sheet for a file staged in the
app cache `exports/` directory. The credential vault has no command and no
permission: it is reachable from Rust only.

#### This default permission set includes the following:

- `allow-share-file`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`mobile-support:allow-share-file`

</td>
<td>

Enables the share_file command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`mobile-support:deny-share-file`

</td>
<td>

Denies the share_file command without any pre-configured scope.

</td>
</tr>
</table>
