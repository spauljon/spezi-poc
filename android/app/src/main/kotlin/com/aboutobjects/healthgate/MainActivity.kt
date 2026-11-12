package com.aboutobjects.healthgate

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.Modifier
import com.aboutobjects.healthgate.ui.HomeScreen
import com.aboutobjects.healthgate.ui.HomeViewModel

class MainActivity : ComponentActivity() {
    private val model: HomeViewModel by viewModels { HomeViewModel.Factory((application as HealthGateApplication).container) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // edge to edge with system-bar icons that follow the light or dark theme (a white clock on a light page is unreadable)
        enableEdgeToEdge()
        setContent {
            MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()) {
                Surface(Modifier.safeDrawingPadding()) { HomeScreen(model) }
            }
        }
    }
}
