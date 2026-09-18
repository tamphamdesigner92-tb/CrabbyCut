{
  "targets": [
    {
      "target_name": "core_c",
      "sources": ["src/core_c.cpp"],
      "include_dirs": [
        "../../node_modules/node-addon-api"
      ],
      "dependencies": [
        "../../node_modules/node-addon-api/node_api.gyp:nothing"
      ],
      "cflags_cc": ["-std=c++17", "-fexceptions"],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17"
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "AdditionalOptions": ["/std:c++17"]
        }
      },
      "defines": ["NAPI_CPP_EXCEPTIONS"]
    }
  ]
}
