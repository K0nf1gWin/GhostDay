# O shield e injetado como string JS, nao como codigo Kotlin: nada a manter.
# Nenhum @JavascriptInterface e exposto ao conteudo da pagina — se um dia for,
# a classe precisa ser mantida aqui.

-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

-keep class dev.ghostday.browser.MainActivity { *; }

-dontwarn androidx.webkit.**
