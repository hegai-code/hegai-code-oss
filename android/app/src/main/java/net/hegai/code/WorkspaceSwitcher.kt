package net.hegai.code

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ArrowDropDown
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import net.hegai.code.core.HubState
import net.hegai.code.core.selectableWorkspaces

/** Current workspace as a compact tappable name with a menu of all of them; nothing when the account has one. */
@Composable fun WorkspaceSwitcher(state: HubState, model: HubViewModel, modifier: Modifier = Modifier) {
    val viewer = state.viewer ?: return
    val choices = selectableWorkspaces(viewer.workspaces)
    if (choices.size < 2) return
    val current = viewer.workspace?.workspaceId
    val name = viewer.workspaces.firstOrNull { it.workspaceId == current }?.name ?: viewer.workspace?.name ?: return
    var open by remember { mutableStateOf(false) }
    // The start bar also holds the menu, the wordmark and the avatar: on a narrow phone or with big text the name
    // gives way first (ellipsis), never the wordmark.
    val narrow = LocalConfiguration.current.screenWidthDp < 360 || LocalDensity.current.fontScale > 1.3f
    Box(modifier) {
        TextButton({ open = true }, Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Рабочее пространство: $name. Сменить" },
            contentPadding = PaddingValues(start = 12.dp, end = 4.dp)) {
            Text(name, Modifier.widthIn(max = if (narrow) 88.dp else 128.dp), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelLarge)
            Icon(Icons.Outlined.ArrowDropDown, null)
        }
        DropdownMenu(open, { open = false }) {
            choices.forEach { workspace ->
                DropdownMenuItem(
                    text = { Text(workspace.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    trailingIcon = if (workspace.workspaceId == current) { { Icon(Icons.Outlined.Check, "Выбрано") } } else null,
                    onClick = { open = false; if (workspace.workspaceId != current) model.switchWorkspace(workspace.workspaceId) },
                )
            }
        }
    }
}
